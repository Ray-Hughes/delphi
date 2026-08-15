const { app, BrowserWindow, globalShortcut, ipcMain, shell, screen, Tray, Menu, nativeImage, nativeTheme, Notification, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const paths = require("./paths");
const { isNewer } = require("./version");

// Before anything reads it. Packaged, the name comes from the bundle, but running
// from a checkout Electron falls back to its own name and the macOS menu bar reads
// "Electron" instead of "Delphi".
app.setName("Delphi");

const db = require("./db");
const vault = require("./vault");
const oracle = require("./oracle");
const embeddings = require("./embeddings");

const isMac = process.platform === "darwin";
const SETTINGS_PATH = paths.SETTINGS_PATH;
const DEFAULT_HOTKEY = "Control+T";
const REPO = "https://github.com/Ray-Hughes/delphi";

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
  // Follow the system unless told otherwise, which is how the window behaved
  // before the setting existed.
  theme: "system",
  // Memory notes are markdown written by agents and read by people, so reading
  // is the default and the source is a switch away.
  noteView: "formatted",
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
  paths.ensureDataDir();
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

/** Whether dark tokens are the ones currently in force. */
const darkNow = () =>
  settings.theme === "dark" || (settings.theme !== "light" && nativeTheme.shouldUseDarkColors);

/**
 * Colours for the Windows window control overlay.
 *
 * These are the --surface and --ink-dim tokens from index.html. They have to be
 * repeated here because the buttons are drawn by Windows rather than by the page,
 * so a stylesheet cannot reach them, and a mismatch shows as a block of the wrong
 * colour in the corner of the title bar.
 */
const overlay = () =>
  darkNow()
    ? { color: "#171b23", symbolColor: "#98a1b2", height: 46 }
    : { color: "#ffffff", symbolColor: "#5a6376", height: 46 };

/**
 * Window chrome, which is the one place the two platforms cannot share a setting.
 *
 * macOS insets its traffic lights into the app's own bar and the page leaves room
 * for them. Windows has no such thing: a frameless window there has no minimise,
 * maximise or close at all, so the overlay puts the real system buttons on top of
 * our bar. A panel is frameless on both, because it is dismissed by clicking away.
 */
function chromeFor(panel) {
  if (isMac) return { frame: false, titleBarStyle: "hiddenInset" };
  if (panel) return { frame: false };
  return { titleBarStyle: "hidden", titleBarOverlay: overlay() };
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
    icon: path.join(__dirname, "assets", "mark-64.png"),
    backgroundColor: darkNow() ? "#0f1217" : "#f4f6f9",
    ...chromeFor(panel),
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
    // The platform goes with it: the title bar has to leave room for traffic
    // lights on the left on macOS and for the control overlay on the right on
    // Windows, and the page cannot work out which from CSS alone.
    win.webContents.send("mode", {
      panelMode: panel,
      platform: process.platform,
      overlay: !isMac && !panel,
    });
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
  if (!win || !win.isVisible()) return;

  // Closing a full screened window used to leave macOS sitting in the empty
  // space it had made for it. The window was hidden, the space was not, so the
  // screen went black and looked like the app had failed to close.
  //
  // Leaving full screen has to finish before the hide, or the hide races the
  // animation and the space is kept anyway.
  if (win.isFullScreen()) {
    win.once("leave-full-screen", () => {
      if (win && !win.isDestroyed()) win.hide();
    });
    win.setFullScreen(false);
    return;
  }

  win.hide();
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

/**
 * The tray image for the menu bar this platform actually has.
 *
 * macOS wants a template image: black plus alpha, which the system inverts itself
 * for a dark menu bar. Handing it a coloured icon is why some apps show a dark
 * blob on a dark menu bar.
 *
 * Windows draws the icon exactly as given, and its taskbar follows the system
 * theme, so one colour is legible on one and nearly invisible on the other. The
 * system setting is read directly rather than through the app's own theme
 * preference: pinning the window to dark does not repaint the taskbar.
 */
function trayIcon() {
  const file = isMac
    ? "trayTemplate.png"
    : nativeTheme.shouldUseDarkColors ? "tray-win-on-dark.png" : "tray-win-on-light.png";
  const icon = nativeImage.createFromPath(path.join(__dirname, "assets", file));
  if (isMac) icon.setTemplateImage(true);
  return icon;
}

function createTray() {
  tray = new Tray(trayIcon());
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
        // Command on a Mac, Control everywhere else. A menu item labelled with a
        // shortcut the platform does not have is worse than one with none.
        label: "Quit Delphi",
        accelerator: "CmdOrCtrl+Q",
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  // A left click toggles on macOS. On Windows a single click is expected to do
  // nothing but select, and the double click is what opens; binding both there
  // would fire twice and land back where it started.
  if (isMac) tray.on("click", toggle);
  else tray.on("double-click", toggle);
}

// ---------------------------------------------------------------------------
// The application menu
//
// Without one, Electron installs a default menu whose first item is named after
// the executable, which is why an unpackaged run says "Electron". Setting a menu
// fixes the name, but a menu of items that do nothing is its own bug, so every
// entry here either drives the window or is a role the platform implements.
//
// Anything that acts on what is on screen is sent to the renderer as a single
// "menu" message rather than reaching into the page from here. That keeps the one
// rule the codebase already has: the main process owns data, the renderer owns
// what is displayed.
// ---------------------------------------------------------------------------

/** Sends a menu action to the window, opening it first if it is hidden. */
function toRenderer(action, payload) {
  if (!win || win.isDestroyed()) createWindow();
  if (!win.isVisible()) show();
  win.webContents.send("menu", { action, ...payload });
}

function buildMenu() {
  const template = [];

  if (isMac) {
    template.push({
      label: "Delphi",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings", accelerator: "CmdOrCtrl+,", click: () => toRenderer("settings") },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" },
        { label: "Quit Delphi", accelerator: "CmdOrCtrl+Q", click: () => { app.isQuitting = true; app.quit(); } },
      ],
    });
  }

  template.push({
    label: "File",
    submenu: [
      { label: "New Task", accelerator: "CmdOrCtrl+N", click: () => toRenderer("new-task") },
      { label: "New Note", accelerator: "CmdOrCtrl+Shift+N", click: () => toRenderer("new-note") },
      { label: "New Project", accelerator: "CmdOrCtrl+Shift+P", click: () => toRenderer("new-project") },
      { type: "separator" },
      { label: "Open Database Folder", click: () => shell.showItemInFolder(db.DB_PATH) },
      { label: "Open Vault Folder", click: () => shell.openPath(settings.vaultPath || vault.DEFAULT_VAULT) },
      { label: "Back Up Database", click: backupDatabase },
      { type: "separator" },
      ...(isMac
        ? [{ role: "close" }]
        : [
            { label: "Settings", accelerator: "CmdOrCtrl+,", click: () => toRenderer("settings") },
            { type: "separator" },
            { label: "Quit Delphi", accelerator: "CmdOrCtrl+Q", click: () => { app.isQuitting = true; app.quit(); } },
          ]),
    ],
  });

  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" }, { role: "redo" },
      { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      { type: "separator" },
      // Not the browser's find bar, which would search the rendered page. This is
      // the app's own search across tasks, notes and the graph.
      { label: "Search Everything", accelerator: "CmdOrCtrl+F", click: () => toRenderer("search") },
      { label: "Undo Last Change", click: () => toRenderer("undo-last") },
    ],
  });

  template.push({
    label: "View",
    submenu: [
      { label: "What's New", accelerator: "CmdOrCtrl+1", click: () => toRenderer("view", { view: "new" }) },
      { label: "Tasks", accelerator: "CmdOrCtrl+2", click: () => toRenderer("view", { view: "tasks" }) },
      { label: "Memory", accelerator: "CmdOrCtrl+3", click: () => toRenderer("view", { view: "notes" }) },
      { label: "History", accelerator: "CmdOrCtrl+4", click: () => toRenderer("view", { view: "history" }) },
      { type: "separator" },
      { label: "Back", accelerator: "CmdOrCtrl+[", click: () => toRenderer("back") },
      { type: "separator" },
      {
        label: "Appearance",
        submenu: ["system", "light", "dark"].map((choice) => ({
          label: choice[0].toUpperCase() + choice.slice(1),
          type: "radio",
          checked: settings.theme === choice,
          click: () => setTheme(choice),
        })),
      },
      {
        label: "Panel Mode",
        type: "checkbox",
        checked: settings.panelMode === true,
        click: (item) => setPanelMode(item.checked),
      },
      { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
      { type: "separator" },
      { role: "reload" }, { role: "toggleDevTools" },
    ],
  });

  template.push({
    label: "Oracle",
    submenu: [
      { label: "Rebuild Knowledge Graph", click: () => runAndReport("Knowledge graph rebuilt", () => oracle.rebuild(db.handle())) },
      { label: "Reindex Embeddings", click: () => runAndReport("Embeddings reindexed", () => embeddings.reindex(db.handle(), { force: true })) },
      { label: "Export Vault Now", click: () => runAndReport("Vault exported", () => vault.exportAll(db, settings.vaultPath || vault.DEFAULT_VAULT)) },
      { type: "separator" },
      { label: "Connect an AI Agent", click: () => shell.openExternal(`${REPO}#connecting-an-ai-agent`) },
    ],
  });

  template.push({
    label: "Window",
    submenu: isMac
      ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
      : [{ role: "minimize" }, { role: "zoom" }],
  });

  template.push({
    role: "help",
    submenu: [
      { label: "Check for Updates", click: () => checkForUpdate({ quiet: false }) },
      ...(latestSeen
        ? [{
            label: `Download ${latestSeen.tag_name}`,
            click: () => shell.openExternal(latestSeen.html_url),
          }]
        : []),
      { type: "separator" },
      { label: "Documentation", click: () => shell.openExternal(REPO) },
      { label: "Report an Issue", click: () => shell.openExternal(`${REPO}/issues/new`) },
      { type: "separator" },
      { label: `Version ${app.getVersion()}`, enabled: false },
      { label: "Show Data Folder", click: () => shell.openPath(paths.DATA_DIR) },
    ],
  });

  return Menu.buildFromTemplate(template);
}

/** Rebuilt rather than mutated, because the radio and checkbox states are read
 *  from settings when the template is built. */
function refreshMenu() {
  Menu.setApplicationMenu(buildMenu());
}

function setTheme(choice) {
  settings.theme = choice;
  saveSettings();
  refreshMenu();
  if (win && !win.isDestroyed()) {
    win.webContents.send("menu", { action: "theme", theme: choice });
    if (!isMac && settings.panelMode !== true && win.setTitleBarOverlay) win.setTitleBarOverlay(overlay());
  }
}

function setPanelMode(next) {
  if (next === (settings.panelMode === true)) return;
  settings.panelMode = next;
  saveSettings();
  rebuildWindow();
  refreshMenu();
}

async function backupDatabase() {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: "Back up the Delphi database",
    defaultPath: path.join(app.getPath("documents"), `delphi-${stamp}.db`),
    filters: [{ name: "SQLite database", extensions: ["db"] }],
  });
  if (canceled || !filePath) return;
  try {
    // Through SQLite rather than a file copy. The database runs in write-ahead
    // mode, so recent rows can still be sitting in delphi.db-wal and copying the
    // file alone produces a backup that is quietly missing the last session.
    db.handle().exec(`VACUUM INTO '${filePath.replace(/'/g, "''")}'`);
    dialog.showMessageBox({ type: "info", message: "Backed up", detail: filePath });
  } catch (error) {
    dialog.showErrorBox("Backup failed", String(error.message || error));
  }
}

/** Runs a maintenance action and says what happened, rather than appearing to do
 *  nothing at all. */
async function runAndReport(message, work) {
  try {
    const result = await work();
    const detail = result && typeof result === "object" ? JSON.stringify(result) : undefined;
    if (win && !win.isDestroyed()) win.webContents.send("alerts-changed");
    dialog.showMessageBox({ type: "info", message, detail });
  } catch (error) {
    dialog.showErrorBox("That did not work", String(error.message || error));
  }
}

// ---------------------------------------------------------------------------
// Updates
//
// Not an auto updater. Squirrel, which is what electron-updater drives on macOS,
// will not install over an app that is not signed with a Developer ID, and these
// builds are ad-hoc signed. Wiring one in would fail silently on the platform
// most of these installs are on, which is worse than not having it.
//
// So this checks and tells you, and takes you to the download. When there is a
// certificate, this becomes the notification that an update is already
// installing rather than the one that asks you to go and get it.
// ---------------------------------------------------------------------------

let latestSeen = null;

async function checkForUpdate({ quiet = true } = {}) {
  try {
    const response = await fetch("https://api.github.com/repos/Ray-Hughes/delphi/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const release = await response.json();
    const available = isNewer(release.tag_name, app.getVersion());
    latestSeen = available ? release : null;
    refreshMenu();

    if (available) {
      // Announced once per launch rather than every check, because a reminder
      // every hour about the same version is nagging, not helping.
      const note = new Notification({
        title: `Delphi ${release.tag_name} is out`,
        body: "You are on " + app.getVersion() + ". Click to download it.",
      });
      note.on("click", () => shell.openExternal(release.html_url));
      note.show();
    } else if (!quiet) {
      dialog.showMessageBox({
        type: "info",
        message: "Delphi is up to date",
        detail: `You are on ${app.getVersion()}, which is the latest release.`,
      });
    }
    return available;
  } catch (error) {
    // Offline, rate limited, or GitHub having a bad day. Silent unless asked.
    if (!quiet) dialog.showErrorBox("Could not check for updates", String(error.message || error));
    return false;
  }
}

app.whenReady().then(() => {
  loadSettings();
  // Before the database is opened for the first time, or the migration finds a
  // file already there and declines to do anything.
  if (app.isPackaged) paths.migrateLegacyDatabase();
  createWindow();
  createTray();
  refreshMenu();
  registerHotkey(settings.hotkey);
  startScheduler();
  scheduleVaultExport();

  // A panel has no dock presence; a normal application does.
  if (app.dock && settings.panelMode === true) app.dock.hide();

  // Late enough not to compete with the first paint, and once only: a desktop
  // app that phones home on a timer is a desktop app people firewall.
  setTimeout(() => checkForUpdate({ quiet: true }), 12000);

  // Following the system means following it while running, not only at startup.
  nativeTheme.on("updated", () => {
    // The Windows taskbar changes with the system rather than with the app's own
    // preference, so the tray icon is swapped whatever the app is pinned to.
    if (!isMac && tray && !tray.isDestroyed()) tray.setImage(trayIcon());
    if (settings.theme !== "system") return;
    if (win && !win.isDestroyed() && !isMac && settings.panelMode !== true && win.setTitleBarOverlay) {
      win.setTitleBarOverlay(overlay());
    }
  });
});

// Windows and Linux keep the process alive with no windows, which for a tray app
// is correct. Clicking the dock icon on macOS should still bring the panel back.
app.on("activate", () => show());

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

function showAlert(alert) {
  const title = alert.project_name ? `${alert.project_name}` : "Reminder";
  const body = alert.message || alert.task_title;

  const notification = new Notification({
    title,
    body,
    // Buttons rather than a text reply, so snoozing is one click. macOS only:
    // Windows takes its buttons from a toast XML document instead, and passing
    // these there is ignored rather than an error, so snoozing on Windows is done
    // from the panel.
    ...(isMac ? { actions: [{ type: "button", text: "Snooze" }], closeButtonText: "Dismiss" } : {}),
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
    // The write-ahead log as well as the database, and the newest of the two.
    //
    // In WAL mode another process's writes land in delphi.db-wal, and delphi.db
    // itself is not touched until a checkpoint. A checkpoint does not happen
    // while this app holds the database open, so watching delphi.db alone meant
    // an agent could write through the MCP server and nothing here ever noticed:
    // no vault export, no graph rebuild, no refresh. That is the exact case this
    // function was written for, and it could not see it.
    let changed = 0;
    for (const suffix of ["", "-wal"]) {
      try {
        changed = Math.max(changed, fs.statSync(db.DB_PATH + suffix).mtimeMs);
      } catch {
        // No write-ahead log yet, which is normal on a fresh database.
      }
    }
    if (!changed) return;

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
  // Async, and the result awaited, because several handlers are. Returning
  // { data: <pending promise> } cannot be sent across the boundary, so those
  // handlers silently produced nothing: the Oracle reported that it had no
  // results rather than that it had never run.
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
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
handle("tasks:detail", (id) => db.taskDetail(id));
handle("tasks:queue", (id, queue) => { const r = db.setQueue(id, queue); scheduleVaultExport(); return r; });
handle("queue:state", (queue) => db.queueState(queue));
handle("tasks:comment", (taskId, body, author) => {
  const r = db.createComment({ taskId, body, author });
  scheduleVaultExport();
  return r;
});
handle("tasks:uncomment", (id) => db.deleteComment(id));

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
handle("audit:project", (projectId, limit) => db.projectActivity(projectId, limit));
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
      refreshMenu();
      return settings;
    }
  }
  // Presentation preferences. Validated against their allowed values rather
  // than stored as given, so a bad write cannot leave the renderer applying an
  // attribute no stylesheet answers to.
  const choices = {
    theme: ["system", "light", "dark"],
    noteView: ["formatted", "raw"],
  };
  for (const [key, allowed] of Object.entries(choices)) {
    if (fields[key] !== undefined) {
      if (!allowed.includes(fields[key])) throw new Error(`${key} must be one of ${allowed.join(", ")}`);
      settings[key] = fields[key];
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
  // The Appearance menu carries a radio mark, and the Windows control overlay is
  // painted by the system rather than by the stylesheet. Both are stale the moment
  // the theme is changed from inside the window instead of from the menu.
  if (fields.theme !== undefined) {
    refreshMenu();
    if (win && !win.isDestroyed() && !isMac && settings.panelMode !== true && win.setTitleBarOverlay) {
      win.setTitleBarOverlay(overlay());
    }
  }
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
