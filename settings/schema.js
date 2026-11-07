// Every global setting, defined once.
//
// main.js used to keep three lists that had to agree: the defaults object, the
// settings:set handler (a hand-written allowlist, which silently dropped any
// field it did not name), and the Settings page, which said what each one was
// for. They did not agree. vaultEnabled and vaultPath were read and never
// writable from the window, and a call that changed panelMode returned before
// saving anything else in it. So this file is the only list. main/settings.js
// builds the defaults and the validation from it, and ui/settings.js builds the
// form, the search index and the Cmd+K entries from it. A new setting is one
// entry here and nothing else; tools/settings_test.js checks that it stays so.
//
// Pure and dependency-free: the main process requires it, and the renderer
// loads it with a <script> tag under a CSP that allows nothing else. The checks
// that need the database or the disk (does project 12 exist, is that folder
// safe to mirror into) are asked of a ctx the caller hands in. A ctx without
// one of those hooks skips that check, which is what the renderer does when it
// only wants to know whether a value is shaped right.

(function (root) {
  "use strict";

  // The panel's sections, in the order the list shows them. `group` is the
  // small heading above a run of them.
  const SECTIONS = [
    { id: "overview", label: "Overview", icon: "today", group: "", lede: "Is everything working, and what have you changed. The same checks as delphi doctor." },
    { id: "general", label: "General", icon: "gear", group: "You", lede: "How Delphi's window behaves on this computer." },
    { id: "appearance", label: "Appearance", icon: "palette", group: "You", lede: "How Delphi looks. Every change shows at once, across the whole window." },
    { id: "shortcuts", label: "Shortcuts", icon: "keyboard", group: "You", lede: "The one shortcut that works from anywhere, and every key inside the window." },
    { id: "agents", label: "Agents and harnesses", icon: "sparkle", group: "Work", lede: "The agent command lines Delphi can launch, and who checks whose work." },
    { id: "jobs", label: "Jobs and approvals", icon: "shield", group: "Work", lede: "How many agent jobs run, for how long, and which ones wait for you." },
    { id: "workbenches", label: "Workbenches", icon: "branch", group: "Work", lede: "A Workbench is a task's own folder and branch, so two pieces of work never share a checkout." },
    { id: "memory", label: "Memory", icon: "memory", group: "Work", lede: "Where agents keep their working notes, how notes open, and the folder everything is mirrored to." },
    { id: "focus", label: "Focus and Today", icon: "focus", group: "Habits", lede: "Reminders, snoozing, and Focus mode: its breaks and what Interruption asks." },
    { id: "brief", label: "Brief and weekly review", icon: "clock", group: "Habits", lede: "When Today offers the weekly review: a look back at the week, a tidy of what went quiet, and next week's few objectives." },
    { id: "data", label: "Data and backups", icon: "db", group: "System", lede: "Where Delphi keeps everything, and how to get back to an earlier day." },
    { id: "privacy", label: "Privacy", icon: "lock", group: "System", lede: "What leaves this computer, who it goes to, and what never does." },
    { id: "advanced", label: "Advanced", icon: "wrench", group: "System", lede: "Numbers most people never touch, the files behind these pages, and the old Settings page." },
    { id: "about", label: "About", icon: "info", group: "System", lede: "Which Delphi this is." },
  ];

  // Curated accents. Each pair is a fill (buttons, dots, the current tab) and
  // an ink (text in the accent). White on the fill and the ink on every ground
  // reach 4.5:1 in both themes; tools/settings_test.js recomputes that from
  // these numbers and styles/tokens.css, so a colour edited later cannot slip
  // under AA. The first is the default, one step darker than Direction B's own
  // #6366F1 and #8B5CF6, which carry white at 4.47 and 4.23 to 1.
  const ACCENTS = [
    { id: "indigo", label: "Indigo", light: ["#4F46E5", "#4338CA"], dark: ["#6D5EF0", "#A5B4FC"] },
    { id: "violet", label: "Violet", light: ["#7C3AED", "#6D28D9"], dark: ["#7C4DEB", "#C4B5FD"] },
    { id: "blue", label: "Blue", light: ["#2563EB", "#1D4ED8"], dark: ["#2F6BEA", "#93C5FD"] },
    { id: "teal", label: "Teal", light: ["#0F766E", "#0F766E"], dark: ["#0D7C73", "#5EEAD4"] },
    { id: "green", label: "Green", light: ["#15803D", "#166534"], dark: ["#178042", "#86EFAC"] },
    { id: "amber", label: "Amber", light: ["#B45309", "#92400E"], dark: ["#B4560B", "#FCD34D"] },
    { id: "rose", label: "Rose", light: ["#E11D48", "#BE123C"], dark: ["#D61F4D", "#FDA4AF"] },
    { id: "graphite", label: "Graphite", light: ["#475569", "#334155"], dark: ["#55657B", "#CBD5E1"] },
  ];

  /*
   * One entry per setting. The fields:
   *   key        the settings.json name
   *   section    where the panel shows it; null for one no person sets by hand
   *   group      the small heading it sits under inside its section
   *   label      what it is called, in plain words
   *   desc       one sentence: what it does
   *   notChanged what it does not change, so nobody turns it on hoping it does
   *   synonyms   other words people search for it by
   *   type       bool, enum, int, text, path, shortcut, or one of the RULES
   *   default    the value a fresh install has
   *   choices    for an enum, [[value, label], ...]
   *   min, max, unit   for an int, and rangeLabel when the bounds read better in words
   *   nullable   null (or an empty string) is a value: "use the default"
   *   effect     what the main process does after saving it (main.js maps these)
   *   restart    "window" when saving it rebuilds the window; done last
   *   danger     { title, body, confirm } when turning it on needs a yes first
   *   dangerWhen the value that needs the yes (default: true)
   *   internal   kept by the app itself (pins, notices); not on the form, not exported
   *   portable   false when the value only means something on this computer, so
   *              an export leaves it out
   *   scope      "machine": settings.json. Per-project settings live on the
   *              project row and are linked from the panel, not listed here.
   */
  const SETTINGS = [
    // --- General -----------------------------------------------------------
    {
      key: "panelMode", section: "general", group: "Window", type: "bool", default: false,
      label: "Panel mode",
      desc: "Float above other windows and hide when Delphi loses focus. Off is a normal window you can full screen and switch to like any other app.",
      notChanged: "The show and hide shortcut, the theme, or anything in the database.",
      synonyms: ["float", "menu bar", "tray", "always on top", "dock", "window behaviour", "window behavior"],
      restart: "window", effect: "window",
    },

    {
      key: "taskOpenMode", section: "general", group: "Tasks", type: "enum", default: "drawer",
      choices: [["drawer", "Drawer"], ["centered", "Centered view"]],
      label: "Open tasks in",
      desc: "The drawer keeps the list beside the task; the centered view gives the task the middle of the window. Shift and Enter on a task in a list opens it in the other one.",
      notChanged: "Notes and pads, which open in the drawer either way.",
      synonyms: ["drawer", "centered", "centred", "modal", "full view", "task panel", "side panel", "task sheet"],
    },

    // --- Appearance --------------------------------------------------------
    {
      // Dark for a new install, the look v2 was designed in (owner decision).
      // An install whose file predates the setting keeps "system":
      // main/settings.js readSettingsFile.
      key: "theme", section: "appearance", group: "Theme", type: "enum", default: "dark",
      choices: [["system", "System"], ["light", "Light"], ["dark", "Dark"]],
      label: "Theme",
      desc: "System follows the computer's setting and changes with it. Light and Dark pin the window whatever the computer says.",
      notChanged: "The menu bar or the Dock, which the system draws.",
      synonyms: ["dark mode", "light mode", "night", "colour scheme", "color scheme", "appearance"],
      effect: "theme",
    },
    {
      key: "accent", section: "appearance", group: "Accent", type: "enum", default: "indigo",
      choices: ACCENTS.map((a) => [a.id, a.label]),
      label: "Accent colour",
      desc: "Buttons, the current tab, focus rings and selection. Every choice keeps text readable (WCAG AA) in both themes.",
      notChanged: "Project and task colours, which are each item's own.",
      synonyms: ["color", "colour", "highlight", "tint", "brand", "purple", "blue", "green"],
    },
    {
      key: "density", section: "appearance", group: "Text and spacing", type: "enum", default: "comfortable",
      choices: [["compact", "Compact"], ["comfortable", "Comfortable"], ["spacious", "Spacious"]],
      label: "Density",
      desc: "The space between rows and around cards. Compact fits about a quarter more on a screen.",
      notChanged: "What is shown: only the spacing around it.",
      synonyms: ["spacing", "padding", "compact", "tight", "roomy", "rows"],
    },
    {
      key: "fontSize", section: "appearance", group: "Text and spacing", type: "int", default: 13, min: 12, max: 16, unit: "px",
      label: "Text size",
      desc: "Scales the whole window, text and controls together, so nothing ends up cramped.",
      notChanged: "The system's own zoom, or other apps.",
      synonyms: ["font", "font size", "zoom", "bigger", "smaller", "scale", "readability"],
    },
    {
      key: "animations", section: "appearance", group: "Motion", type: "bool", default: true,
      label: "Animate the interface",
      desc: "Slides, fades, and the small burst when a task is ticked off, which is the confirmation that it was done before the row leaves.",
      notChanged: "The system's Reduce motion setting, which turns them off whatever this says.",
      synonyms: ["motion", "reduce motion", "celebration", "confetti", "transitions"],
    },

    // --- Shortcuts ---------------------------------------------------------
    {
      key: "hotkey", section: "shortcuts", group: "Everywhere", type: "shortcut", default: "Control+T",
      label: "Show and hide Delphi",
      desc: "Works from anywhere on this computer, even when Delphi is in the background. Click Record, then press the keys.",
      notChanged: "The shortcuts inside the window, such as Cmd+K.",
      synonyms: ["global hotkey", "summon", "toggle", "keyboard shortcut", "accelerator"],
      effect: "hotkey",
    },
    {
      // A single key, not a chord: Focus is something to reach without
      // thinking. The choices are only letters nothing else in the window
      // answers to (G, J, K and E are the list's, and I, B and D are Focus's
      // own once it is open), so no choice here can shadow another key.
      key: "focusLetter", section: "shortcuts", group: "In the window", type: "enum", default: "f",
      choices: [["f", "F"], ["o", "O"], ["u", "U"], ["off", "No key"]],
      label: "Open Focus mode with",
      desc: "One key, pressed anywhere in the window outside a text box. Focus is in Cmd+K and on the bar at the top either way.",
      notChanged: "The keys inside Focus: I for an interruption, B for a break, D for done, Esc to leave.",
      synonyms: ["focus", "deep work", "zen", "distraction free", "single task", "keyboard"],
    },

    // --- Agents and harnesses ----------------------------------------------
    {
      key: "secondOpinionMode", section: "agents", group: "Second opinion", type: "bool", default: false,
      label: "Ask another agent to check reviews and diagnoses",
      desc: "Connected agents call second_opinion before a commit and when they reach a root cause. Delphi sends the question, not the answer.",
      notChanged: "Who decides: the first agent still decides, and you still review.",
      synonyms: ["second opinion", "review", "cross-check", "copilot", "double check"],
      danger: {
        title: "Ask every connected agent to get a second opinion?",
        body: "It changes how every agent sharing this database works, and each second opinion spends the other agent's quota, up to the hourly limit below.",
        confirm: "Turn it on",
      },
    },
    {
      key: "secondOpinionAgent", section: "agents", group: "Second opinion", type: "harnessKey", default: "copilot",
      label: "Second opinion from",
      desc: "Which agent answers. It must be on and found on this computer.",
      notChanged: "Which agent does the work in the first place.",
      synonyms: ["reviewer", "checker", "copilot", "codex", "claude"],
    },
    {
      key: "secondOpinionHourlyLimit", section: "agents", group: "Second opinion", type: "int", default: 12, min: 0, max: 60, unit: "an hour",
      label: "At most, per hour",
      desc: "Across every agent on this database, so a loop cannot spend your premium requests. 0 stops them.",
      notChanged: "Second opinions already started.",
      synonyms: ["limit", "quota", "rate limit", "premium requests", "budget"],
    },

    // --- Jobs and approvals ------------------------------------------------
    {
      key: "jobConcurrency", section: "jobs", group: "Limits", type: "int", default: 3, min: 1, max: 8, unit: "jobs",
      label: "Jobs at once",
      desc: "How many agent jobs run at the same time, in all.",
      notChanged: "Jobs already running. A lower number only holds back the next ones.",
      synonyms: ["concurrency", "parallel", "limit", "how many", "at once", "queue"],
      effect: "dispatcher",
    },
    {
      key: "jobHarnessLimits", section: "jobs", group: "Limits", type: "harnessLimits", default: {}, min: 0, max: 4,
      label: "Per-agent limits",
      desc: "Subscriptions throttle, so each agent runs one job at a time unless raised. 0 pauses an agent.",
      notChanged: "The total, which Jobs at once still caps.",
      synonyms: ["limit", "per agent", "throttle", "pause agent", "subscription"],
      effect: "dispatcher",
    },
    {
      key: "jobTimeoutMinutes", section: "jobs", group: "Limits", type: "int", default: 60, min: 1, max: 1440, unit: "minutes", rangeLabel: "1 minute to 24 hours",
      label: "Stop a run after",
      desc: "A run still going after this long is stopped, and its Sheet says so.",
      notChanged: "Runs waiting on you, which have no clock.",
      synonyms: ["timeout", "time limit", "kill", "stop", "long running", "limit"],
    },

    // --- Workbenches -------------------------------------------------------
    {
      // Not portable: it is a command Delphi runs, and an import is a file
      // anyone could have sent.
      key: "workbenchEditor", section: "workbenches", group: "Opening a Workbench", type: "text", default: null, nullable: true, maxLength: 200, portable: false,
      label: "Open a Workbench with",
      desc: "The command, split like a shell would split it, with the folder added at the end. Empty uses VS Code's code when it is installed, else the system's default for a folder.",
      notChanged: "Where the Workbench folder is, or which branch it is on.",
      synonyms: ["editor", "ide", "vs code", "cursor", "code", "open in"],
      placeholder: "code",
    },
    {
      key: "workbenchBranchPrefix", section: "workbenches", group: "Branches", type: "branchPrefix", default: null, nullable: true,
      label: "Branch names start with",
      desc: "So a shared remote shows whose branch is whose. Letters, digits, dots, hyphens and underscores, up to 40. Empty uses your username.",
      notChanged: "Branches that already exist; only new Workbenches use it.",
      synonyms: ["branch prefix", "git", "naming", "username"],
    },

    // --- Memory ------------------------------------------------------------
    {
      key: "scratchpadMode", section: "memory", group: "Agents' working notes", type: "bool", default: false,
      label: "Agents keep their working notes here",
      desc: "Connected agents write plans and findings to a pad in Delphi instead of a temporary folder, so you and the next session can read them.",
      notChanged: "Files that have to be files to work, such as scripts an agent runs. Agents already connected pick it up within seconds.",
      synonyms: ["scratchpad", "pads", "drafts", "plans", "temp files", "working document"],
      danger: {
        title: "Tell every connected agent to write its notes here?",
        body: "It changes how every agent sharing this database works: their plans and findings land in pads you can read, instead of in temporary files.",
        confirm: "Turn it on",
      },
    },
    {
      key: "scratchpadProjectId", section: "memory", group: "Agents' working notes", type: "projectId", default: null, nullable: true, portable: false,
      label: "Default project for pads",
      desc: "Where a pad goes when nothing more specific fits. Empty lets the agent choose.",
      notChanged: "Pads already written.",
      synonyms: ["scratchpad project", "default project", "where drafts go"],
    },
    {
      key: "noteView", section: "memory", group: "Notes", type: "enum", default: "formatted",
      choices: [["formatted", "Formatted"], ["raw", "Markdown source"]],
      label: "Open notes as",
      desc: "Notes are markdown written by agents and read by people, so reading is the default and the source is a switch away.",
      notChanged: "The note itself.",
      synonyms: ["markdown", "raw", "source", "preview", "rendered"],
    },
    {
      key: "vaultEnabled", section: "memory", group: "Vault", type: "bool", default: true,
      label: "Mirror everything to a folder",
      desc: "Notes, pads and Sheets as plain markdown files, rebuilt shortly after each change. Readable by Obsidian or any editor.",
      notChanged: "The database. Turning it off leaves the folder as it is.",
      synonyms: ["vault", "obsidian", "markdown export", "mirror", "files"],
      effect: "vault",
    },
    {
      key: "vaultPath", section: "memory", group: "Vault", type: "path", default: null, nullable: true, portable: false,
      label: "Vault folder",
      desc: "Where the mirror is written. Empty uses the default folder. The vault removes markdown it did not write, so it must be a folder of its own.",
      notChanged: "The old folder, which is left as it is.",
      synonyms: ["vault path", "obsidian folder", "export folder", "location"],
      effect: "vault",
      danger: {
        title: "Mirror into this folder?",
        body: "Delphi rewrites this folder after every change and deletes any markdown file in it that it did not write. Choose a folder that holds nothing else.",
        confirm: "Use this folder",
      },
      dangerWhen: "any",
    },

    // --- Focus and Today ---------------------------------------------------
    {
      key: "autoRemindBeforeDueHours", section: "focus", group: "Reminders", type: "int", default: 24, min: 1, max: 720, unit: "hours", rangeLabel: "1 hour to 30 days",
      label: "Offer to remind me before a due date",
      desc: "How far ahead the task panel offers a reminder on a task with a due date.",
      notChanged: "Anything on its own: it is a suggestion, and nothing is scheduled without you asking.",
      synonyms: ["due", "deadline", "reminder", "ahead", "notify"],
    },
    {
      key: "snoozeMinutes", section: "focus", group: "Reminders", type: "int", default: 10, min: 1, max: 1440, unit: "minutes", rangeLabel: "1 minute to a day",
      label: "Snooze for",
      desc: "How long Snooze puts a reminder off.",
      notChanged: "Reminders already snoozed.",
      synonyms: ["snooze", "later", "postpone", "remind me later"],
    },
    {
      // Text, not numbers, because the panel's select hands back text and an
      // enum is compared exactly.
      key: "focusBreakMinutes", section: "focus", group: "Focus mode", type: "enum", default: "30",
      choices: [["15", "15 minutes"], ["30", "30 minutes"], ["60", "60 minutes"]],
      label: "Break length offered first",
      desc: "Which of the three lengths Focus's Break button has ready, so B then Enter starts it.",
      notChanged: "The other two, which are always one click away, or a break already running.",
      synonyms: ["break", "rest", "pomodoro", "pause", "timer"],
    },
    {
      key: "focusTriage", section: "focus", group: "Focus mode", type: "bool", default: true,
      label: "Ask the three questions on an interruption",
      desc: "Can it wait three hours, does it keep the business running, can AI do it. Off, Interruption offers the three outcomes as plain buttons instead.",
      notChanged: "What each outcome does: file it for later, switch to it now, or hand it to an agent.",
      synonyms: ["interruption", "triage", "questions", "eisenhower", "urgent"],
    },

    // --- Brief and weekly review -------------------------------------------
    {
      key: "weeklyReviewEnabled", section: "brief", group: "Weekly review", type: "bool", default: true,
      label: "Offer the weekly review on Today",
      desc: "On your review day Today shows a Weekly review card until you save next week's objectives.",
      notChanged: "Cmd+K's Weekly review or the weekly_review tool for agents, which work every day either way.",
      synonyms: ["weekly", "review", "retro", "retrospective", "planning", "objectives", "sunsama"],
    },
    {
      key: "weeklyReviewDay", section: "brief", group: "Weekly review", type: "enum", default: "friday",
      choices: [["monday", "Monday"], ["tuesday", "Tuesday"], ["wednesday", "Wednesday"], ["thursday", "Thursday"],
                ["friday", "Friday"], ["saturday", "Saturday"], ["sunday", "Sunday"]],
      label: "Review day",
      desc: "The day Today offers the review. It always looks back over the seven days before it, whichever day it is.",
      notChanged: "Which week the review covers, or the daily brief.",
      synonyms: ["day", "weekday", "friday", "sunday", "when"],
    },

    // --- Advanced ----------------------------------------------------------
    {
      key: "checkIntervalSeconds", section: "advanced", group: "Timing", type: "int", default: 60, min: 5, max: 3600, unit: "seconds", rangeLabel: "5 seconds to an hour",
      label: "Check for due reminders every",
      desc: "A minute is frequent enough for reminders measured in minutes and cheap enough to ignore.",
      notChanged: "When a reminder is due, only how soon after it the notice appears.",
      synonyms: ["interval", "scheduler", "poll", "frequency", "reminders"],
      effect: "scheduler",
    },

    // --- Kept by the app itself --------------------------------------------
    {
      key: "pinnedProjects", section: null, internal: true, type: "projectList", default: [],
      label: "Pinned projects",
      desc: "Projects kept at the top of the switcher, in your order. Pin and unpin from a project's menu.",
      synonyms: ["pin", "favourites", "favorites"],
    },
    {
      key: "hiddenFromActive", section: null, internal: true, type: "hiddenList", default: [],
      label: "Hidden from Active",
      desc: "Projects taken out of Active, each with when. Touching one brings it back, so hiding means not now.",
      synonyms: ["hide", "hidden projects"],
    },
    {
      key: "checkoutNoticeSeen", section: null, internal: true, type: "checkoutNotice", default: null, nullable: true,
      label: "Checkout database notice seen",
      desc: "The ignored checkout database you have already been told about, so the notice shows once per file.",
      synonyms: [],
    },
    {
      // Kept here rather than in the window's storage so a break survives a
      // restart: the window comes back blurred, counting down to the same end.
      key: "focusBreakUntil", section: null, internal: true, type: "breakEnd", default: null, nullable: true, portable: false,
      label: "Break ends at",
      desc: "When the running Focus break ends, in milliseconds since 1970, or nothing when there is no break.",
      synonyms: [],
    },
  ];

  // No prototype, so "__proto__" or "constructor" is no setting rather than
  // Object's own machinery.
  const BY_KEY = Object.assign(Object.create(null), Object.fromEntries(SETTINGS.map((s) => [s.key, s])));
  const has = (key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(BY_KEY, key);
  const TIME = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
  const MODIFIER = /^(Command|Cmd|Control|Ctrl|CommandOrControl|CmdOrCtrl|Alt|Option|AltGr|Shift|Super|Meta)$/;

  const fail = (s, sentence) => { const e = new Error(sentence); e.key = s.key; throw e; };
  // A value that has to be text arrives as text, or as nothing: an object
  // would otherwise be stored as "[object Object]".
  const textOf = (s, v) => {
    if (v == null) return "";
    if (typeof v !== "string") fail(s, `${s.label} must be text.`);
    return v.trim();
  };
  const isPlain = (v) => v != null && typeof v === "object" && !Array.isArray(v);
  const clone = (v) => (v == null || typeof v !== "object" ? v : JSON.parse(JSON.stringify(v)));

  function whole(s, value, min, max, what = s.label) {
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
      fail(s, `${what} must be a whole number from ${min} to ${max}.`);
    }
    return n;
  }

  // The rules a plain type cannot say. Each takes the value as given and
  // returns it as it will be stored, or throws the sentence the window shows.
  const RULES = {
    bool(s, v) {
      if (v !== true && v !== false) fail(s, `${s.label} is on or off: true or false.`);
      return v;
    },
    enum(s, v) {
      if (!s.choices.some(([c]) => c === v)) fail(s, `${s.label} must be one of ${s.choices.map(([c]) => c).join(", ")}.`);
      return v;
    },
    int(s, v) { return whole(s, v, s.min, s.max); },
    text(s, v) {
      const t = textOf(s, v);
      if (t.length > s.maxLength) fail(s, `${s.label} must be ${s.maxLength} characters or fewer.`);
      return t || null;
    },
    // Checked against what git accepts in a ref, because a prefix git refuses
    // would make every Start fail with git's message instead of this one.
    branchPrefix(s, v) {
      const t = textOf(s, v);
      if (t && (!/^[A-Za-z0-9._-]{1,40}$/.test(t) || /^[.-]|\.\.|\.lock$|\.$/.test(t))) {
        fail(s, "The branch prefix may use letters, digits, dots, hyphens and underscores, up to 40, and cannot start with a dot or hyphen.");
      }
      return t || null;
    },
    // A harness key, not a command: the server looks the row up by it, so
    // anything that could not be one is refused here rather than there.
    harnessKey(s, v) {
      const t = textOf(s, v);
      if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(t)) fail(s, "The second opinion must come from an agent's key, such as copilot.");
      return t;
    },
    // An Electron accelerator: modifiers joined by +, then one key.
    shortcut(s, v) {
      const t = textOf(s, v);
      const parts = t.split("+");
      const key = parts.pop();
      if (!t || t.length > 60 || !key || MODIFIER.test(key) || !parts.every((p) => MODIFIER.test(p)) || /\s/.test(key)) {
        fail(s, "A shortcut is modifier keys and one more key, such as Control+T.");
      }
      // A bare letter, or Shift and a letter, would be taken from typing in
      // every app on the computer, so those are only ever function keys.
      if (!parts.some((p) => p !== "Shift") && !/^F([1-9]|1\d|2[0-4])$/.test(key)) fail(s, "A shortcut needs Command, Control or Option, unless it is a function key.");
      if (key.length > 1 && !/^(F([1-9]|1\d|2[0-4])|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Esc|Escape|Plus|num[0-9])$/.test(key)) fail(s, `"${key}" is not a key Delphi can bind.`);
      return t;
    },
    // Absolute, because a relative path would be read against wherever the
    // app happened to start. Whether the folder is safe to mirror into is the
    // main process's to say (ctx.vaultFolderProblem), since the vault deletes
    // markdown it did not write.
    path(s, v, ctx) {
      const t = textOf(s, v);
      if (!t) return null;
      const absolute = ctx.isAbsolute ? ctx.isAbsolute(t) : /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(t);
      if (t.length > 1024 || /\0/.test(t) || !absolute) fail(s, `${s.label} must be a full path to a folder.`);
      if (ctx.vaultFolderProblem) { const why = ctx.vaultFolderProblem(t); if (why) fail(s, why); }
      return t;
    },
    // Checked against the projects that exist, because this id is handed to
    // agents as the place to write. A stale id would send them at a project
    // that is not there and turn every draft into a failed call.
    projectId(s, v, ctx) {
      if (v === null || v === "" || v === undefined) return null;
      const id = Number(v);
      if (!Number.isInteger(id) || id <= 0) fail(s, `No project ${v}.`);
      if (ctx.projectExists && !ctx.projectExists(id)) fail(s, `No project ${v}.`);
      return id;
    },
    // Kept in the order given with repeats dropped, every one checked.
    projectList(s, v, ctx) {
      const list = v == null ? [] : v;
      if (!Array.isArray(list)) fail(s, `${s.label} must be a list of project ids.`);
      const ids = [];
      for (const raw of list) {
        const id = Number(raw);
        if (!Number.isInteger(id) || id <= 0 || (ctx.projectExists && !ctx.projectExists(id))) fail(s, `No project ${raw}.`);
        if (!ids.includes(id)) ids.push(id);
      }
      return ids;
    },
    // Unlike pins, a project that no longer exists is dropped rather than
    // refused: the list is rewritten whole on every hide, and one deleted
    // project should not make every later hide fail.
    hiddenList(s, v, ctx) {
      const list = v == null ? [] : v;
      if (!Array.isArray(list)) fail(s, `${s.label} must be a list of { id, at }.`);
      const now = ctx.now ? ctx.now() : new Date().toISOString().slice(0, 19).replace("T", " ");
      const kept = new Map();
      for (const raw of list) {
        const id = Number(raw && typeof raw === "object" ? raw.id : raw);
        if (!Number.isInteger(id) || id <= 0 || (ctx.projectExists && !ctx.projectExists(id))) continue;
        const at = raw && typeof raw === "object" && TIME.test(String(raw.at)) ? String(raw.at) : now;
        kept.set(id, { id, at });
      }
      return [...kept.values()];
    },
    // The whole map, as the window shows it: a harness left out goes back to 1.
    // Keys are harness keys, which is what a job's to_harness holds.
    harnessLimits(s, v) {
      if (!isPlain(v)) fail(s, "Per-agent limits must be an object of agent key to a number.");
      const next = {};
      for (const [key, limit] of Object.entries(v)) {
        if (!/^[A-Za-z0-9._:-]{1,64}$/.test(key)) fail(s, `"${key}" is not an agent's key.`);
        next[key] = whole(s, limit, s.min, s.max, `The limit for ${key}`);
      }
      return next;
    },
    // A moment no more than an hour and a minute away, the longest break plus
    // the time a save can take. Further out would be a window locked by a
    // typo; a past one is allowed, because a restart has to be able to read
    // and then clear a break that ended while Delphi was closed.
    breakEnd(s, v, ctx) {
      const now = ctx.nowMs ? ctx.nowMs() : Date.now();
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > now + 61 * 60000) {
        fail(s, "A break ends within the next hour, as milliseconds since 1970.");
      }
      return v;
    },
    // A path, and only ever the one app:dataInfo reported: anything else would
    // acknowledge a notice nobody was shown.
    checkoutNotice(s, v, ctx) {
      if (v === null) return null;
      if (!("checkoutDbIgnored" in ctx) || v !== ctx.checkoutDbIgnored) {
        fail(s, "checkoutNoticeSeen must be the ignored checkout database app:dataInfo reported, or null.");
      }
      return v;
    },
  };

  /** One value, checked and put in the shape it is stored in. */
  function check(key, value, ctx = {}) {
    const s = has(key) ? BY_KEY[key] : null;
    if (!s) {
      const e = new Error(`Delphi has no setting called "${key}".`);
      e.key = key;
      throw e;
    }
    if (s.nullable && (value === null || value === "") && s.type !== "checkoutNotice") return null;
    return RULES[s.type](s, value, ctx);
  }

  /** The defaults, as a fresh object each time so nobody shares a list by accident. */
  function defaults() {
    return Object.fromEntries(SETTINGS.map((s) => [s.key, clone(s.default)]));
  }

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /**
   * A write, all or nothing. Every field is checked before anything is kept,
   * so one bad field leaves every setting as it was, and a field this file
   * does not name is refused by name instead of dropped: a setting that seems
   * to save and then is not there is the bug this replaced.
   *
   * Returns { values, changed }: values holds each field as it will be
   * stored, and changed the keys whose stored value differs, in the order of
   * SETTINGS, with any `restart` ones last.
   */
  function apply(current, fields, ctx = {}) {
    if (!isPlain(fields)) throw new Error("Settings are saved as an object of setting name to value.");
    const values = {};
    for (const [key, value] of Object.entries(fields)) values[key] = check(key, value, ctx);
    const changed = SETTINGS
      .filter((s) => s.key in values && !same(values[s.key], current ? current[s.key] : undefined))
      .sort((a, b) => Number(Boolean(a.restart)) - Number(Boolean(b.restart)))
      .map((s) => s.key);
    return { values, changed };
  }

  /** Whether a stored value is not the default. */
  function isModified(key, value) {
    const s = BY_KEY[key];
    if (!s) return false;
    const norm = (v) => (s.nullable && (v === "" || v === undefined) ? null : v);
    return !same(norm(value === undefined ? s.default : value), norm(s.default));
  }

  /** Whether moving to this value needs a yes first. */
  function needsConfirm(key, value) {
    const s = BY_KEY[key];
    if (!s || !s.danger) return false;
    if (s.dangerWhen === "any") return value != null && value !== "" && !same(value, s.default);
    return same(value, s.dangerWhen === undefined ? true : s.dangerWhen);
  }

  /**
   * What an export holds: every setting a person sets, without the ones that
   * only mean something on this computer. There are no secrets in
   * settings.json to leave out; the API key is in the system keychain and
   * trusted agent commands are rows in the database, and neither is read here.
   */
  function exportable(settings) {
    const out = {};
    for (const s of SETTINGS) {
      if (s.internal || s.portable === false) continue;
      if (settings && s.key in settings) out[s.key] = clone(settings[s.key]);
    }
    return out;
  }

  /**
   * An imported file's settings, split into what would be applied and what
   * is left out and why. Nothing is saved here; the window shows the
   * difference and the person says yes.
   */
  function importable(data, current, ctx = {}) {
    const given = isPlain(data) && isPlain(data.settings) ? data.settings : data;
    if (!isPlain(given)) throw new Error("That file is not a Delphi settings export.");
    const toApply = {};
    const skipped = [];
    for (const [key, value] of Object.entries(given)) {
      const s = BY_KEY[key];
      if (!s) { skipped.push({ key, why: "Delphi has no setting by that name." }); continue; }
      if (s.internal || s.portable === false) { skipped.push({ key, why: "Only means something on the computer it came from." }); continue; }
      try {
        const v = check(key, value, ctx);
        if (!same(v, current ? current[key] : undefined)) toApply[key] = v;
      } catch (error) {
        skipped.push({ key, why: error.message });
      }
    }
    return { apply: toApply, skipped };
  }

  /** A value in the words the panel and Cmd+K show it in. */
  function describe(key, value) {
    const s = BY_KEY[key];
    if (!s) return "";
    const v = value === undefined ? s.default : value;
    if (s.type === "bool") return v ? "On" : "Off";
    if (s.type === "enum") return (s.choices.find(([c]) => c === v) || [v, String(v)])[1];
    if (s.type === "int") return `${v} ${s.unit}`;
    if (s.type === "harnessLimits") {
      const vals = Object.values(v || {});
      return vals.length ? vals.join(", ") + " each" : "1 each";
    }
    if (v == null || v === "") return "Default";
    if (Array.isArray(v)) return `${v.length}`;
    return String(v);
  }

  /** The text a search runs over, one string per setting, lower case. */
  function searchText(s) {
    return [s.label, s.desc, s.notChanged, ...(s.synonyms || []), s.key, s.group,
      (SECTIONS.find((x) => x.id === s.section) || {}).label].filter(Boolean).join(" \n ").toLowerCase();
  }

  const api = { SECTIONS, SETTINGS, ACCENTS, BY_KEY, check, defaults, apply, isModified, needsConfirm, exportable, importable, describe, searchText };
  root.DelphiSettingsSchema = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
