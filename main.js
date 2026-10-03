const { app, BrowserWindow, globalShortcut, ipcMain, shell, screen, Tray, Menu, nativeImage, nativeTheme, Notification, dialog, safeStorage, clipboard } = require("electron");
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
const ai = require("./ai");
const terminal = require("./terminal");
const git = require("./git");
const harness = require("./harness");

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
  // Whether connected agents are told to use this tracker as their scratchpad
  // instead of writing drafts to temporary files. Off by default: it changes how
  // every agent sharing this database behaves, which is not something to turn on
  // for someone without asking. See agent/directives.js for how it reaches them.
  scratchpadMode: false,
  scratchpadProjectId: null,   // null means "no default, pick a project"
  // On by default because the celebration is the confirmation that a task was
  // completed, and the row leaves straight afterwards. The system reduced motion
  // preference already suppresses all of it for the people who need that, so
  // this is a second, independent off switch rather than the only one.
  animations: true,
};
let schedulerTimer = null;
let vaultTimer = null;
// The last value of PRAGMA data_version, not a timestamp. 0 means "not looked
// yet". See checkForExternalWrites for why it cannot be an mtime.
let lastSeenDbChange = 0;
let dbWatcher = null;
let dbWatchTimer = null;

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
        click: () => app.quit(),
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
        { label: "Quit Delphi", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
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
            { label: "Quit Delphi", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
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
  // Before the window, so the harness strip has rows to draw on the first paint.
  // Guarded because a database that has no registry is still a working tracker,
  // and refusing to start over it would be a poor trade.
  try {
    db.seedHarnesses(harness.BUILTINS);
  } catch (error) {
    console.error("could not seed the harness registry", error);
  }
  createWindow();
  createTray();
  refreshMenu();
  registerHotkey(settings.hotkey);
  startScheduler();
  watchForExternalWrites();
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
// This asks SQLite who wrote, rather than asking the filesystem that something
// did. PRAGMA data_version changes only when a DIFFERENT connection commits;
// writes made through this app's own connection leave it alone. db.js opens
// exactly one connection for the whole app, so "changed" here means precisely
// "an agent, or another copy of Delphi, wrote something".
//
// It has to be that and not a file timestamp, because reacting to an external
// write means rebuilding the graph and re-embedding, and both of those are
// writes. Keyed on mtime, the reaction was itself a change, which triggered the
// next reaction, and the app rewrote the database every couple of seconds
// forever. Every cycle also told the window to refresh, so the view was rebuilt
// under the reader: scrolling jumped back to the top and a selection in progress
// was destroyed as its nodes were replaced.
function checkForExternalWrites() {
  try {
    const version = db.handle().prepare("PRAGMA data_version").get().data_version;

    // First look establishes the baseline. Reacting here would rebuild
    // everything on every launch for no reason.
    if (lastSeenDbChange === 0) {
      lastSeenDbChange = version;
      return;
    }
    if (version !== lastSeenDbChange) {
      lastSeenDbChange = version;
      scheduleVaultExport();
      // A handoff written by an agent arrives as an external write, since the
      // MCP server is a different process. This is what turns "Claude asked
      // Codex" into Codex actually starting, within seconds rather than at the
      // next sweep.
      dispatchHandoffs();
      if (win && !win.isDestroyed()) {
        win.webContents.send("alerts-changed");
        // So an open task panel shows an agent's Sheet entries as they land,
        // rather than when the person next clicks something.
        win.webContents.send("db-changed");
      }
    }
  } catch (error) {
    console.error("could not check the database for external writes", error);
  }
}

/**
 * Notices an agent's write as it happens rather than at the next sweep.
 *
 * The interval below is a minute by default, which is the right cadence for
 * reminders and far too slow for this: an agent says it has written a note, you
 * look, and it is not there. It arrives a minute later, or you restart the app
 * and assume that is what was needed. Watching the file closes that gap to
 * roughly the write itself.
 *
 * The directory is watched rather than the two files. In WAL mode the interesting
 * write lands in delphi.db-wal, which is created and removed rather than only
 * modified, and a watch on a path that disappears stops firing. Debounced because
 * one logical write touches the log several times.
 *
 * The interval stays as the fallback: fs.watch is famously uneven across
 * platforms and network filesystems, so this makes the common case fast without
 * being the only thing that works.
 */
function watchForExternalWrites() {
  if (dbWatcher) { try { dbWatcher.close(); } catch {} dbWatcher = null; }
  try {
    dbWatcher = fs.watch(path.dirname(db.DB_PATH), (_event, filename) => {
      if (filename && !String(filename).startsWith("delphi.db")) return;
      clearTimeout(dbWatchTimer);
      dbWatchTimer = setTimeout(checkForExternalWrites, 250);
    });
  } catch (error) {
    console.error("could not watch the database directory, falling back to polling", error);
  }
}

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(() => {
    sweep();
    checkForExternalWrites();
    // The backstop. Both of these are normally kicked the moment the write that
    // created them lands, and this is what catches the one written by an MCP
    // client while the app was closed.
    dispatchHandoffs();
    fireTimers();
  }, Math.max(15, settings.checkIntervalSeconds) * 1000);
  // Sweep shortly after launch so anything that came due while the app was closed
  // appears rather than waiting for the first interval.
  setTimeout(sweep, 3000);
}

app.on("window-all-closed", (e) => e.preventDefault());

// Every route out of the app, not every button that offers one.
//
// Closing the window hides it rather than quitting, which is what the tray and
// the hotkey need, and that is only correct while the app is not actually
// quitting. The flag saying so was set by the menu items that quit. Every other
// way out left it false: the Dock's own Quit, the Apple menu, a Command Q the
// system handles rather than the menu. The window refused to close, the quit was
// cancelled, and the app carried on running with no window and no explanation.
//
// before-quit fires for all of them, so the flag is set once, here.
app.on("before-quit", () => { app.isQuitting = true; });
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
// Its own channel rather than a flag on projects:list, because every caller of
// that one wants the working set and would have to opt out of the archive.
handle("projects:archived", () => db.listArchivedProjects());
handle("projects:create", (payload) => db.createProject(payload));
handle("projects:update", (id, fields) => db.updateProject(id, fields));
handle("projects:contents", (id) => db.projectContents(id));
// The vault mirrors notes per project, so a deleted project leaves a folder of
// files describing something that no longer exists until the mirror is rebuilt.
handle("projects:delete", (id, opts) => {
  const r = db.deleteProject(id, opts);
  scheduleVaultExport();
  return r;
});

handle("tasks:list", (opts) => db.listTasks(opts));
handle("tasks:create", (payload) => { const r = db.createTask(payload); scheduleVaultExport(); return r; });
handle("tasks:update", (id, fields) => { const r = db.updateTask(id, fields); scheduleVaultExport(); return r; });
handle("tasks:delete", (id) => { const r = db.deleteTask(id); scheduleVaultExport(); return r; });
handle("tasks:detail", (id) => db.taskDetail(id));
handle("tasks:queue", (id, queue) => { const r = db.setQueue(id, queue); scheduleVaultExport(); return r; });
// projectId is optional in both, and leaving it out is the whole pool. The
// global Queue tab passes nothing; a project's Queue tab passes its id.
handle("queue:state", (queue, projectId) => db.queueState(queue, projectId ?? null));
handle("queue:release", (id, note) => { const r = db.releaseClaim(id, { agent: "you", note }); scheduleVaultExport(); return r; });
handle("queue:reclaim", (queue, projectId) => db.reclaimExpired(queue || null, projectId ?? null));
handle("tasks:comment", (taskId, body, author) => {
  const r = db.createComment({ taskId, body, author });
  scheduleVaultExport();
  return r;
});
handle("tasks:uncomment", (id) => db.deleteComment(id));

// ---------------------------------------------------------------------------
// The Sheet. The same store the MCP server uses, handed db.sqlP, so an entry
// written here obeys exactly the rules one written by an agent does. Nothing
// here takes an author from the renderer: the app's writes are the person's.

const { makeSheetStore } = require("./sheet/store");
const sheetFormat = require("./sheet/format");
const sheetRun = require("./sheet/run");
const sheets = makeSheetStore({ sql: db.sqlP, actor: "you", authorType: "human" });
const SHEET_LOG_DIR = path.join(paths.DATA_DIR, "sheets");
// The tail of a log the rail will show. A build log can be hundreds of
// megabytes, and the end is where the error is.
const SHEET_LOG_LIMIT = 200 * 1024;

/**
 * An entry's log, read from where this app would have written it rather than
 * from meta.log. meta is written by agents, and a path taken from it would let
 * any of them have the window display an arbitrary file.
 */
function readSheetLog(entry) {
  const file = sheetRun.logPathFor(SHEET_LOG_DIR, entry.task_id, entry.id);
  let size;
  try { size = fs.statSync(file).size; } catch { return { path: null, text: (entry.meta && entry.meta.out) || "", truncated: false }; }
  const start = Math.max(0, size - SHEET_LOG_LIMIT);
  const buffer = Buffer.alloc(size - start);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, buffer, 0, buffer.length, start); } finally { fs.closeSync(fd); }
  return { path: file, text: sheetFormat.stripAnsi(buffer.toString("utf8")), truncated: start > 0 };
}

/**
 * What copying one entry gives: its source, not its formatted line, so a
 * pasted reply is byte for byte what was said. The command for a run, with
 * its output after it when asked for.
 */
function entryCopyText(entry, { withOutput = false } = {}) {
  if (entry.kind === "ask") {
    const options = (entry.meta && Array.isArray(entry.meta.options)) ? entry.meta.options : [];
    return [entry.body, ...options.map((o) => `[${o.key}] ${o.label}`)].join("\n");
  }
  if (entry.kind === "run" && withOutput) {
    const output = sheetFormat.normaliseBody(readSheetLog(entry).text);
    return output ? `${entry.body}\n${output}` : entry.body;
  }
  return entry.body;
}

handle("sheet:read", (taskId, opts = {}) => {
  const mode = (opts && opts.mode) || "full";
  const read = sheets.read(taskId, { mode, n: opts && opts.n });
  const header = sheets.header(taskId);
  return {
    task: { id: header.task, title: header.title, status: header.status, project: header.project },
    entries: read.entries,
    text: sheetFormat.format({ header, entries: read.entries }, { clean: true }),
    ledger_count: read.ledger_count,
    total: read.total,
    cursor: read.cursor,
  };
});
handle("sheet:append", (taskId, payload = {}) => {
  const kind = (payload && payload.kind) || "say";
  // A run entry written without running anything would be a record of
  // something that never happened.
  if (kind !== "say" && kind !== "note") throw new Error("The app writes say and note entries here. Use sheets.ask for a question.");
  const r = sheets.append({ taskId, kind, body: payload.body, refId: payload.refId ?? null, promote: payload.promote === true });
  scheduleVaultExport();
  return r;
});
handle("sheet:promote", (id, on) => { const r = sheets.promote(id, on !== false); scheduleVaultExport(); return r; });
handle("sheet:file", (id, kind, title) => { const r = sheets.file(id, kind, title || null); scheduleVaultExport(); return r; });
handle("sheet:ask", (taskId, question, options) => { const r = sheets.ask(taskId, question, options); scheduleVaultExport(); return r; });
handle("sheet:decide", (askId, choice, why) => { const r = sheets.decide(askId, choice, why || null); scheduleVaultExport(); return r; });
handle("sheet:log", (id) => readSheetLog(sheets.get(id)));
handle("sheet:copy", (id, opts = {}) => {
  const text = entryCopyText(sheets.get(id), opts || {});
  clipboard.writeText(text);
  return text;
});
handle("sheet:copyAll", (taskId, opts = {}) => {
  const text = sheetFormat.format(sheets.sheet(taskId, { mode: opts && opts.ledger ? "ledger" : "full" }), { clean: true });
  clipboard.writeText(text);
  return text;
});

handle("notes:list", (projectId) => db.listNotes(projectId));
handle("notes:create", (payload) => { const r = db.createNote(payload); scheduleVaultExport(); return r; });
handle("notes:update", (id, fields) => { const r = db.updateNote(id, fields); scheduleVaultExport(); return r; });
handle("notes:delete", (id) => { const r = db.deleteNote(id); scheduleVaultExport(); return r; });

// Pads go through the vault export like notes do: a working document is exactly
// the kind of thing somebody wants to open in Obsidian or grep from a terminal.
handle("pads:list", (projectId) => db.listScratchpads(projectId));
handle("pads:get", (id) => db.getScratchpad(id));
handle("pads:create", (payload) => { const r = db.createScratchpad(payload); scheduleVaultExport(); return r; });
handle("pads:write", (id, fields) => { const r = db.writeScratchpad(id, fields); scheduleVaultExport(); return r; });
handle("pads:append", (id, text) => { const r = db.appendScratchpad(id, text); scheduleVaultExport(); return r; });
handle("pads:delete", (id) => { const r = db.deleteScratchpad(id); scheduleVaultExport(); return r; });
handle("pads:tasks", (id) => db.scratchpadTasks(id));

handle("links:list", (projectId) => db.listLinks(projectId));
handle("links:create", (payload) => db.createLink(payload));
handle("links:delete", (id) => db.deleteLink(id));

// No task handler is added for epics. organizer_id goes through tasks:update
// like any other field, which is what gives the move its audit row for free.
handle("organizers:list", (projectId) => db.listOrganizers(projectId));
handle("organizers:create", (payload) => { const r = db.createOrganizer(payload); scheduleVaultExport(); return r; });
handle("organizers:update", (id, fields) => { const r = db.updateOrganizer(id, fields); scheduleVaultExport(); return r; });
handle("organizers:delete", (id) => { const r = db.deleteOrganizer(id); scheduleVaultExport(); return r; });

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

handle("oracle:graph", (opts) => oracle.graph(db.handle(), opts || {}));

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
// Asking for a folder by typing its absolute path is asking someone to go and
// look it up in Finder and then retype it correctly. The native picker is right
// there and already knows how to browse.
//
// Parented to the window so macOS attaches it as a sheet rather than floating a
// separate dialog that can end up behind the app.
handle("dialog:pickFolder", async (title, options = {}) => {
  const result = await dialog.showOpenDialog(win, {
    title: title || "Choose a folder",
    // Opens where the work already is rather than at the root of the disk. The
    // caller passes the parent of the last project it knows about, so the second
    // project lands beside the first without anyone navigating there again.
    defaultPath: options.defaultPath || app.getPath("home"),
    buttonLabel: options.buttonLabel || undefined,
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
});

/**
 * Makes the folder for a project that was named rather than picked.
 *
 * Two ways to start a project: point at a folder that exists, or type a name and
 * have one made. This is the second. The parent is chosen in the picker, so the
 * only thing invented here is the last path segment.
 *
 * An existing folder is not an error. Someone who types the name of a folder
 * that is already there almost always means "use that one", and refusing would
 * send them to Finder to check what is inside it.
 */
handle("fs:createFolder", async (parent, name) => {
  if (!parent || !name) throw new Error("A folder needs a parent and a name");

  // Anything that could climb out of the parent is rejected rather than
  // sanitised. Silently turning "../etc" into "etc" makes a folder somewhere the
  // person did not ask for, which is worse than telling them the name is no good.
  const clean = String(name).trim();
  if (!clean || clean === "." || clean === ".." || /[\\/]/.test(clean)) {
    throw new Error("A folder name cannot be empty or contain a slash");
  }

  const target = path.join(parent, clean);
  const resolvedParent = path.resolve(parent);
  if (!path.resolve(target).startsWith(resolvedParent + path.sep)) {
    throw new Error("That name would put the folder outside the folder you chose");
  }

  const existed = fs.existsSync(target);
  if (existed && !fs.statSync(target).isDirectory()) {
    throw new Error(`${clean} already exists here and is a file`);
  }
  if (!existed) fs.mkdirSync(target, { recursive: true });
  return { path: target, existed };
});

/** Whether a project's folder is still where it said it was. */
handle("fs:folderExists", (folder) => {
  try {
    return Boolean(folder) && fs.existsSync(folder) && fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
});

handle("fs:reveal", (target) => {
  if (target && fs.existsSync(target)) shell.showItemInFolder(target);
});


// ---------------------------------------------------------------------------
// The model
//
// The renderer cannot reach a network at all: its CSP is default-src 'self'
// with no connect-src. So the request is made here and the reply is pushed back
// a piece at a time on "ai-event", which is the only way a streaming reply can
// cross the boundary.

/**
 * Where the API key lives.
 *
 * Encrypted with the OS key rather than written into settings.json, which is a
 * plain file sitting next to the database. safeStorage uses the Keychain on a
 * Mac, so the key is no more readable than any other Keychain item.
 */
const KEY_FILE = () => path.join(paths.DATA_DIR, "anthropic.key");

function readApiKey() {
  try {
    if (!fs.existsSync(KEY_FILE())) return null;
    const blob = fs.readFileSync(KEY_FILE());
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(blob) || null;
  } catch {
    return null;
  }
}

handle("ai:providers", async (force) => ai.providers({ apiKey: readApiKey(), force: force === true }));
handle("ai:hasKey", () => Boolean(readApiKey()));

handle("ai:setKey", (key) => {
  paths.ensureDataDir();
  if (!key) {
    if (fs.existsSync(KEY_FILE())) fs.unlinkSync(KEY_FILE());
    return { saved: false };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("This machine cannot encrypt secrets, so the key was not saved");
  }
  fs.writeFileSync(KEY_FILE(), safeStorage.encryptString(String(key)), { mode: 0o600 });
  return { saved: true };
});

// Only one turn at a time. A second send while one is running would interleave
// two replies into the same transcript with no way to tell them apart.
let sending = false;

handle("ai:send", async ({ sessionId, provider, model, system, messages, cwd, autoAllow }) => {
  if (sending) throw new Error("A reply is already streaming");
  sending = true;

  const emit = (event) => {
    // The window can be closed mid-stream, and sending to a disposed frame
    // throws rather than being ignored.
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("ai-event", { sessionId, ...event });
    }
  };

  try {
    await ai.send(
      { provider, apiKey: readApiKey(), model, system, messages, cwd, autoAllow },
      emit
    );
  } finally {
    sending = false;
  }
  return { ok: true };
});


// ---------------------------------------------------------------------------
// Harnesses
//
// Somebody else's agent, run as a session. Same shape as ai:send, because from
// the renderer's side it is the same thing: a turn goes out, events come back.
// What differs is that this drives a CLI rather than calling a model, and that
// the CLI is handed Delphi's own MCP server on the way in.

handle("harness:list", (force) =>
  harness.detect(db.listHarnesses(), { force: force === true }));
handle("harness:create", (payload) => db.createHarness(payload));
handle("harness:update", (id, fields) => db.updateHarness(id, fields));
handle("harness:delete", (id) => db.deleteHarness(id));

// One turn per session, not one turn overall. Two harnesses working two
// sessions at once is the case this whole feature exists for; two turns in one
// session would interleave into one transcript with no way to tell them apart.
const turns = new Set();

/**
 * Runs one turn in a harness session.
 *
 * Two callers, and the difference between them is who owns the transcript. The
 * window creates the message rows itself, so it can grow the reply on screen as
 * it arrives; a handoff has no window involved, so this writes them. Hence
 * `collect`: on that path the reply is accumulated and stored here, and the
 * events still go to the window in case it happens to be looking.
 */
async function runTurn({ sessionId, prompt, system = null, autoAllow, collect = false }) {
  if (turns.has(sessionId)) throw new Error("This session is already working");

  const session = db.getSession(sessionId);
  if (!session) throw new Error("No such session");
  const row = db.getHarness(session.harness);
  if (!row) throw new Error(`This session names a harness that no longer exists: ${session.harness}`);
  if (!row.enabled) throw new Error(`${row.label} is turned off in Settings`);

  const cwd = session.cwd || sessionFolder(session);
  if (!cwd) throw new Error("This project has no folder, so there is nowhere for an agent to work");

  turns.add(sessionId);
  db.updateSession(sessionId, { run_state: "running", last_run_at: new Date().toISOString() });

  let text = "";
  let failure = null;
  let reply = null;
  if (collect) {
    db.appendMessage({ sessionId, role: "user", content: prompt });
    reply = db.appendMessage({ sessionId, role: "assistant", content: "" });
  }

  try {
    await harness.start({
      harness: { ...row, args: row.args_json },
      sessionId,
      cwd,
      prompt,
      system,
      model: session.model || null,
      resume: session.native_id || null,
      autoAllow: autoAllow === true || session.auto_allow === 1,
      dbPath: db.DB_PATH,
      projectId: session.project_id,
      // What the audit trail will say. This is the point of the whole
      // arrangement: every row the agent writes is attributed to the tab it was
      // written from, so History reads as a log of who did what.
      actor: `${row.key}:${sessionId}`,
    }, (event) => {
      // The CLI's own id for the conversation, kept so the next turn resumes
      // rather than replaying the transcript as one prompt. Written as it
      // arrives rather than at the end, because a turn that is interrupted has
      // still started a conversation on the other side.
      if (event.type === "session" && event.nativeId && event.nativeId !== session.native_id) {
        db.updateSession(sessionId, { native_id: event.nativeId });
      }
      if (event.type === "error") failure = event.message;
      if (event.type === "text") text += event.text;
      if (event.type === "tool" && collect) {
        text += `${text && !text.endsWith("\n\n") ? "\n\n" : ""}> \u25b8 **${event.name}**\n\n`;
      }
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send("ai-event", { sessionId, ...event });
      }
    });
  } finally {
    turns.delete(sessionId);
    db.updateSession(sessionId, { run_state: failure ? "failed" : "idle" });
    if (collect && reply) {
      db.updateMessage(reply.id, failure ? { error: failure } : { content: text });
    }
  }
  return { text, failure };
}

handle("harness:start", ({ sessionId, prompt, system, autoAllow }) =>
  runTurn({ sessionId, prompt, system, autoAllow }).then(() => ({ ok: true })));

// ---------------------------------------------------------------------------
// Handoffs
//
// An agent asking another agent. The MCP server can only write the row: it runs
// in a separate process with no registry and no window, so it cannot spawn
// anything. This is the half that reads those rows and runs them, and it is here
// because this is where the harnesses already live.

handle("handoffs:list", (opts) => db.listHandoffs(opts || {}));
handle("handoffs:create", (payload) => {
  const created = db.createHandoff(payload);
  // Straight away rather than at the next sweep. A minute of nothing happening
  // is how a feature like this gets a reputation for not working.
  setTimeout(dispatchHandoffs, 50);
  return created;
});
handle("handoffs:cancel", (id) => db.updateHandoff(id, { status: "cancelled" }));
handle("locks:list", (projectId) => db.listLocks(projectId ?? null));
handle("locks:release", (projectId, key, holder) => db.releaseLock({ projectId, key, holder }));

// One dispatch at a time. Two overlapping passes would both see the same queued
// row and run it twice, and "twice" here means two agents doing the same work in
// the same folder.
let dispatching = false;

async function dispatchHandoffs() {
  if (dispatching) return;
  dispatching = true;
  try {
    for (const handoff of db.pendingHandoffs()) {
      try {
        await runHandoff(handoff);
      } catch (error) {
        db.updateHandoff(handoff.id, { status: "failed", reply: String(error.message || error) });
      }
    }
  } finally {
    dispatching = false;
    if (win && !win.isDestroyed()) win.webContents.send("alerts-changed");
  }
  // The wake, straight after the work. Outside the guard so a wake that itself
  // hands something off does not deadlock against the pass that is still
  // holding it.
  await fireTimers();
}

/**
 * Runs one handoff, in the receiving agent's own session.
 *
 * Its own session rather than a throwaway, so "ask Codex" means the same Codex
 * that has been working this project all week and knows what it looked at an
 * hour ago. That continuity is most of the value: a reviewer with no memory of
 * the codebase is a worse reviewer.
 */
// How many handoffs one project may finish in an hour before Delphi stops
// running them by itself. Two agents that each wake the other are a loop that
// spends money at machine speed with nobody watching, and a limit somebody has
// to raise deliberately is the only thing that reliably stops it.
const HANDOFF_LIMIT_PER_HOUR = 12;

async function runHandoff(handoff) {
  if (db.handoffsSince(handoff.project_id, 1) >= HANDOFF_LIMIT_PER_HOUR) {
    db.updateHandoff(handoff.id, {
      status: "failed",
      reply:
        `Delphi stopped this one. ${HANDOFF_LIMIT_PER_HOUR} handoffs have already finished in this ` +
        `project in the last hour, which usually means two agents are handing work back and forth. ` +
        `Nothing is lost: the request is on the handoff and can be run again.`,
    });
    return;
  }
  const target = db.getHarness(handoff.to_harness);
  if (!target || !target.enabled) {
    db.updateHandoff(handoff.id, {
      status: "failed",
      reply: `There is no agent called "${handoff.to_harness}" turned on here.`,
    });
    return;
  }

  let session = db.listSessions(handoff.project_id).find((x) => x.harness === handoff.to_harness);
  if (!session) {
    session = db.createSession({
      projectId: handoff.project_id,
      title: target.label,
      harness: handoff.to_harness,
    });
  }
  db.updateHandoff(handoff.id, { status: "running", to_session_id: session.id });

  const from = handoff.from_session_id ? db.getSession(handoff.from_session_id) : null;
  const context = handoff.context_json ? `\n\nContext:\n${handoff.context_json}` : "";
  const task = handoff.task_id ? db.taskDetail(handoff.task_id) : null;
  const asked = from ? (from.harness || "the Delphi chat") : "the person using Delphi";

  const { text, failure } = await runTurn({
    sessionId: session.id,
    collect: true,
    prompt:
      `A request has been handed to you through Delphi by ${asked}.\n\n` +
      `${handoff.request}${context}` +
      (task ? `\n\nThis is about task ${task.task.id}: ${task.task.title}` : "") +
      `\n\nAnswer it directly. Your reply goes straight back to whoever asked, ` +
      `so write it for them rather than for a person reading a terminal.`,
  });

  db.updateHandoff(handoff.id, {
    status: failure ? "failed" : "ready",
    reply: failure || text,
  });

  // The wake. The sender's turn ended minutes ago, so the only way it learns the
  // answer is to be given a turn of its own, which is what a timer is for. Due
  // now rather than later: there is nothing to wait for, and the delay would
  // only be there to look like waiting.
  if (!failure && handoff.wake && handoff.from_session_id) {
    db.createAlert({
      sessionId: handoff.from_session_id,
      kind: "harvest",
      fireAt: new Date().toISOString().slice(0, 19).replace("T", " "),
      payload: { handoffId: handoff.id },
    });
  }
}

/**
 * Wakes a session that was waiting on something.
 *
 * Only when the session is idle. Interrupting a turn in flight with a second
 * prompt would interleave two conversations, and the alert stays pending, so it
 * fires again on the next sweep rather than being lost.
 */
async function fireTimers() {
  for (const timer of db.dueTimers()) {
    if (turns.has(timer.session_id)) continue;
    let payload = {};
    try { payload = JSON.parse(timer.payload || "{}"); } catch {}

    if (timer.kind === "harvest" && payload.handoffId) {
      const handoff = db.getHandoff(payload.handoffId);
      if (!handoff || handoff.status !== "ready") { db.updateAlert(timer.id, { status: "done" }); continue; }
      db.updateAlert(timer.id, { status: "done" });
      db.updateHandoff(handoff.id, { status: "harvested" });
      try {
        await runTurn({
          sessionId: timer.session_id,
          collect: true,
          prompt:
            `${handoff.to_harness} has answered the request you handed over.\n\n` +
            `You asked: ${handoff.request}\n\n` +
            `It replied:\n${handoff.reply}\n\n` +
            `Carry on from there.`,
        });
      } catch (error) {
        console.error("could not wake a session with a handoff reply", error);
      }
      continue;
    }

    // A plain timer: something asked to be woken at a time, with a note.
    db.updateAlert(timer.id, { status: "done" });
    try {
      await runTurn({
        sessionId: timer.session_id,
        collect: true,
        prompt: timer.message || "The timer you set has come due.",
      });
    } catch (error) {
      console.error("could not fire a timer", error);
    }
  }
  if (win && !win.isDestroyed()) win.webContents.send("alerts-changed");
}

handle("harness:stop", (sessionId) => {
  const stopped = harness.stop(sessionId);
  if (stopped) db.updateSession(sessionId, { run_state: "idle" });
  return { stopped };
});

/**
 * Which folder a session runs in.
 *
 * A project can span four repositories, and a harness needs one answer. The
 * session's own choice wins; then the workspace marked primary; then the
 * project's own path, which is the older way of saying the same thing.
 */
function sessionFolder(session) {
  if (session.cwd) return session.cwd;
  const spaces = db.workspacesForProject(session.project_id) || [];
  const primary = spaces.find((w) => w.is_primary) || spaces[0];
  if (primary) return primary.path;
  const project = db.getProject(session.project_id);
  return project ? project.path : null;
}

// ---------------------------------------------------------------------------
// Terminal
//
// Same shape as the model stream: the renderer cannot spawn a process, so the
// command runs here and its output is pushed back a piece at a time.

handle("term:start", ({ id, cwd, command }) => {
  if (!cwd) throw new Error("This project has no folder, so there is nowhere to run a command");
  return terminal.start({ id, cwd, command }, (event) => {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("term-event", { id, ...event });
    }
  });
});

handle("term:write", (id, text) => terminal.write(id, text));
handle("term:stop", (id) => terminal.stop(id));
handle("term:sessions", () => terminal.sessions());

handle("git:status", (folder) => git.status(folder));
handle("git:commit", (folder, message, opts) => git.commit(folder, message, opts));
handle("git:log", (folder, limit) => git.log(folder, limit));

// Anything still running belongs to a window that is going away.
app.on("will-quit", () => { try { terminal.stopAll(); } catch {} });

handle("workspaces:list", () => db.listWorkspaces());
handle("workspaces:create", (payload) => db.createWorkspace(payload));
handle("workspaces:update", (id, fields) => db.updateWorkspace(id, fields));
handle("workspaces:delete", (id) => db.deleteWorkspace(id));
handle("workspaces:projects", (id) => db.projectsInWorkspace(id));
handle("workspaces:forProject", (projectId) => db.workspacesForProject(projectId));
handle("workspaces:link", (projectId, workspaceId, opts) => db.linkProjectWorkspace(projectId, workspaceId, opts));
handle("workspaces:unlink", (projectId, workspaceId) => db.unlinkProjectWorkspace(projectId, workspaceId));

handle("sessions:list", (projectId) => db.listSessions(projectId));
handle("sessions:get", (id) => db.getSession(id));
handle("sessions:create", (payload) => db.createSession(payload));
handle("sessions:update", (id, fields) => db.updateSession(id, fields));
handle("sessions:delete", (id) => db.deleteSession(id));
handle("messages:list", (sessionId) => db.listMessages(sessionId));
handle("messages:append", (payload) => db.appendMessage(payload));
handle("messages:update", (id, fields) => db.updateMessage(id, fields));
handle("sessions:addUsage", (id, usage) => db.addSessionUsage(id, usage));

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

  if (fields.scratchpadMode !== undefined) settings.scratchpadMode = fields.scratchpadMode === true;

  if (fields.animations !== undefined) settings.animations = fields.animations !== false;

  // Checked against the projects that exist, because this id is handed to agents
  // as the place to write. A stale id would send them at a project that is not
  // there and turn every draft into a failed call.
  if (fields.scratchpadProjectId !== undefined) {
    const value = fields.scratchpadProjectId;
    if (value === null || value === "") {
      settings.scratchpadProjectId = null;
    } else {
      const id = Number(value);
      if (!Number.isInteger(id) || !db.getProject(id)) throw new Error(`No project ${value}`);
      settings.scratchpadProjectId = id;
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
